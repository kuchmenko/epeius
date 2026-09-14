package quote

import (
	"fmt"
	"sort"
	"sync"
	"time"

	atomicv1 "github.com/kuchmenko/epeius/generated/go/epeius/atomic/v1"
	quotev1 "github.com/kuchmenko/epeius/generated/go/epeius/quote/v1"
	"google.golang.org/protobuf/proto"
)

const retention = 30 * time.Second
const storeLimit = 1024

type storedQuote struct {
	request   *quotev1.QuoteRequest
	final     *quotev1.QuoteFinal
	expires   time.Time
	approvals map[string]bool
}

type preparation struct {
	executionPlan
	response *quotev1.PrepareExecutionResponse
	chain    string
	expires  time.Time
	approval bool
}

type storedAtomicQuote struct {
	response         *atomicv1.PlanQuoteResponse
	chain            string
	expires          time.Time
	approvalRequired bool
	retainedBytes    uint64
}

type atomicPreparation struct {
	response         *atomicv1.PreparePlanResponse
	chain            string
	expires          time.Time
	executorPlanHash []byte
	checks           SimulationChecks
	retainedBytes    uint64
}

type AtomicStoreLimits struct {
	MaxQuotes           uint32
	MaxQuoteBytes       uint64
	MaxPreparations     uint32
	MaxPreparationBytes uint64
}

type AtomicLimits struct {
	MaxRequestBytes  int
	MaxResponseBytes int
	Store            AtomicStoreLimits
}

type resourceLimitError struct {
	resource string
	actual   uint64
	allowed  uint64
}

func (e resourceLimitError) Error() string {
	return fmt.Sprintf("%s size %d exceeds configured limit %d", e.resource, e.actual, e.allowed)
}

type Store struct {
	mu                     sync.Mutex
	quotes                 map[string]storedQuote
	preparations           map[string]preparation
	atomicQuotes           map[string]storedAtomicQuote
	atomicPlans            map[string]atomicPreparation
	atomicLimits           AtomicStoreLimits
	atomicQuoteBytes       uint64
	atomicPreparationBytes uint64
}

func NewStore(limits ...AtomicStoreLimits) *Store {
	store := &Store{
		quotes: map[string]storedQuote{}, preparations: map[string]preparation{},
		atomicQuotes: map[string]storedAtomicQuote{}, atomicPlans: map[string]atomicPreparation{},
	}
	if len(limits) != 0 {
		store.atomicLimits = limits[0]
	}
	return store
}

// prune requires the Store mutex. No Store operation performs network calls.
func (s *Store) prune(now time.Time) {
	for id, q := range s.quotes {
		if !now.Before(q.expires) {
			delete(s.quotes, id)
		}
	}
	for id, p := range s.preparations {
		if !now.Before(p.expires) {
			delete(s.preparations, id)
		}
	}
	for id, q := range s.atomicQuotes {
		if !now.Before(q.expires) {
			s.atomicQuoteBytes -= q.retainedBytes
			delete(s.atomicQuotes, id)
		}
	}
	for id, p := range s.atomicPlans {
		if !now.Before(p.expires) {
			s.atomicPreparationBytes -= p.retainedBytes
			delete(s.atomicPlans, id)
		}
	}
}

func (s *Store) saveQuote(r *quotev1.QuoteRequest, f *quotev1.QuoteFinal, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune(time.Now())
	if len(s.quotes) >= storeLimit {
		var oldest string
		var expiry time.Time
		for id, q := range s.quotes {
			if oldest == "" || q.expires.Before(expiry) {
				oldest, expiry = id, q.expires
			}
		}
		delete(s.quotes, oldest)
	}
	s.quotes[f.QuoteId] = storedQuote{proto.CloneOf(r), proto.CloneOf(f), now.Add(retention), map[string]bool{}}
}

func (s *Store) savePreparation(p preparation) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune(time.Now())
	if len(s.preparations) >= storeLimit {
		var oldest string
		var expiry time.Time
		for id, v := range s.preparations {
			if oldest == "" || v.expires.Before(expiry) {
				oldest, expiry = id, v.expires
			}
		}
		delete(s.preparations, oldest)
	}
	p.response = proto.CloneOf(p.response)
	p.transaction = proto.CloneOf(p.transaction)
	p.atomicPlan = proto.CloneOf(p.atomicPlan)
	p.permission = p.permission.clone()
	p.checks = p.checks.clone()
	s.preparations[p.response.PreparationId] = p
}

// Atomic byte limits count reproducible logical payload bytes, not
// allocator-specific object overhead: canonical protobuf, UTF-8 strings,
// byte slices, booleans, and expiry as an int64 Unix timestamp.
func atomicQuoteRetainedBytes(chain string, response *atomicv1.PlanQuoteResponse) uint64 {
	return uint64(proto.Size(response) + len(chain) + 1 + 8)
}

func simulationChecksRetainedBytes(checks SimulationChecks) uint64 {
	var size uint64
	for _, probe := range append(append([]BalanceProbe(nil), checks.Preserve...), checks.Input, checks.Output) {
		size += uint64(len(probe.Token) + len(probe.Owner))
	}
	for _, probe := range checks.ClearAllowances {
		size += uint64(len(probe.Token) + len(probe.Owner) + len(probe.Spender))
	}
	return size
}

func atomicPreparationRetainedBytes(value atomicPreparation) uint64 {
	return uint64(proto.Size(value.response)+len(value.chain)+len(value.executorPlanHash)+8) + simulationChecksRetainedBytes(value.checks)
}

func deterministicAtomicVictim[T any](values map[string]T, expiry func(T) time.Time) string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		left, right := expiry(values[keys[i]]), expiry(values[keys[j]])
		return left.Before(right) || (left.Equal(right) && keys[i] < keys[j])
	})
	return keys[0]
}

func (s *Store) saveAtomicQuote(chain string, response *atomicv1.PlanQuoteResponse, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune(now)
	retained := atomicQuoteRetainedBytes(chain, response)
	limits := s.atomicLimits
	if limits.MaxQuotes == 0 || limits.MaxQuoteBytes == 0 {
		limits.MaxQuotes, limits.MaxQuoteBytes = storeLimit, ^uint64(0)
	}
	if retained > limits.MaxQuoteBytes {
		return resourceLimitError{"retained Atomic quote", retained, limits.MaxQuoteBytes}
	}
	key := string(response.QuoteId)
	if old, ok := s.atomicQuotes[key]; ok {
		s.atomicQuoteBytes -= old.retainedBytes
		delete(s.atomicQuotes, key)
	}
	for len(s.atomicQuotes) >= int(limits.MaxQuotes) || retained > limits.MaxQuoteBytes-s.atomicQuoteBytes {
		victim := deterministicAtomicVictim(s.atomicQuotes, func(value storedAtomicQuote) time.Time { return value.expires })
		s.atomicQuoteBytes -= s.atomicQuotes[victim].retainedBytes
		delete(s.atomicQuotes, victim)
	}
	s.atomicQuotes[key] = storedAtomicQuote{response: proto.CloneOf(response), chain: chain, expires: now.Add(retention), retainedBytes: retained}
	s.atomicQuoteBytes += retained
	return nil
}

func (s *Store) atomicQuote(id []byte, now time.Time) (storedAtomicQuote, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune(now)
	value, ok := s.atomicQuotes[string(id)]
	value.response = proto.CloneOf(value.response)
	return value, ok
}

func (s *Store) markAtomicApproval(id []byte, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune(now)
	value, ok := s.atomicQuotes[string(id)]
	if !ok || value.approvalRequired {
		return false
	}
	value.approvalRequired = true
	s.atomicQuotes[string(id)] = value
	return true
}

func (s *Store) saveAtomicPreparation(value atomicPreparation, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune(now)
	retained := atomicPreparationRetainedBytes(value)
	limits := s.atomicLimits
	if limits.MaxPreparations == 0 || limits.MaxPreparationBytes == 0 {
		limits.MaxPreparations, limits.MaxPreparationBytes = storeLimit, ^uint64(0)
	}
	if retained > limits.MaxPreparationBytes {
		return resourceLimitError{"retained Atomic preparation", retained, limits.MaxPreparationBytes}
	}
	key := string(value.response.Preparation.PreparationId)
	if old, ok := s.atomicPlans[key]; ok {
		s.atomicPreparationBytes -= old.retainedBytes
		delete(s.atomicPlans, key)
	}
	for len(s.atomicPlans) >= int(limits.MaxPreparations) || retained > limits.MaxPreparationBytes-s.atomicPreparationBytes {
		victim := deterministicAtomicVictim(s.atomicPlans, func(value atomicPreparation) time.Time { return value.expires })
		s.atomicPreparationBytes -= s.atomicPlans[victim].retainedBytes
		delete(s.atomicPlans, victim)
	}
	value.response = proto.CloneOf(value.response)
	value.executorPlanHash = append([]byte(nil), value.executorPlanHash...)
	value.checks = value.checks.clone()
	value.retainedBytes = retained
	s.atomicPlans[key] = value
	s.atomicPreparationBytes += retained
	return nil
}

func (s *Store) atomicPreparation(id []byte, now time.Time) (atomicPreparation, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune(now)
	value, ok := s.atomicPlans[string(id)]
	value.response = proto.CloneOf(value.response)
	value.executorPlanHash = append([]byte(nil), value.executorPlanHash...)
	value.checks = value.checks.clone()
	return value, ok
}

// lookup returns detached terms; approval bookkeeping never leaves the Store.
func (s *Store) lookup(quoteID, preparationID string, now time.Time) (storedQuote, bool, preparation, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune(now)
	q, found := s.quotes[quoteID]
	p, recheck := s.preparations[preparationID]
	q.request = proto.CloneOf(q.request)
	q.final = proto.CloneOf(q.final)
	q.approvals = nil
	p.response = proto.CloneOf(p.response)
	p.transaction = proto.CloneOf(p.transaction)
	p.atomicPlan = proto.CloneOf(p.atomicPlan)
	p.permission = p.permission.clone()
	p.checks = p.checks.clone()
	return q, found, p, recheck
}

// markApproval atomically observes and records whether this quote needed approval.
// A quote that needed approval must never become an executable swap later.
func (s *Store) markApproval(quoteID, key string, required bool, now time.Time) (previous, found bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune(now)
	q, found := s.quotes[quoteID]
	if !found {
		return false, false
	}
	previous = q.approvals[key]
	if required {
		q.approvals[key] = true
	}
	return previous, true
}
