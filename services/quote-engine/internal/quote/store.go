package quote

import (
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
}

type atomicPreparation struct {
	response         *atomicv1.PreparePlanResponse
	chain            string
	expires          time.Time
	executorPlanHash []byte
	checks           SimulationChecks
}

type Store struct {
	mu           sync.Mutex
	quotes       map[string]storedQuote
	preparations map[string]preparation
	atomicQuotes map[string]storedAtomicQuote
	atomicPlans  map[string]atomicPreparation
}

func NewStore() *Store {
	return &Store{
		quotes: map[string]storedQuote{}, preparations: map[string]preparation{},
		atomicQuotes: map[string]storedAtomicQuote{}, atomicPlans: map[string]atomicPreparation{},
	}
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
			delete(s.atomicQuotes, id)
		}
	}
	for id, p := range s.atomicPlans {
		if !now.Before(p.expires) {
			delete(s.atomicPlans, id)
		}
	}
}

func evictOldest[T any](values map[string]T, expiry func(T) time.Time) {
	if len(values) < storeLimit {
		return
	}
	var oldest string
	var earliest time.Time
	for id, value := range values {
		if oldest == "" || expiry(value).Before(earliest) {
			oldest, earliest = id, expiry(value)
		}
	}
	delete(values, oldest)
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

func (s *Store) saveAtomicQuote(chain string, response *atomicv1.PlanQuoteResponse, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune(now)
	evictOldest(s.atomicQuotes, func(value storedAtomicQuote) time.Time { return value.expires })
	s.atomicQuotes[string(response.QuoteId)] = storedAtomicQuote{response: proto.CloneOf(response), chain: chain, expires: now.Add(retention)}
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

func (s *Store) saveAtomicPreparation(value atomicPreparation, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune(now)
	evictOldest(s.atomicPlans, func(value atomicPreparation) time.Time { return value.expires })
	value.response = proto.CloneOf(value.response)
	value.executorPlanHash = append([]byte(nil), value.executorPlanHash...)
	value.checks = value.checks.clone()
	s.atomicPlans[string(value.response.Preparation.PreparationId)] = value
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
