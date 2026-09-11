package quote

import (
	"sync"
	"time"

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

type Store struct {
	mu           sync.Mutex
	quotes       map[string]storedQuote
	preparations map[string]preparation
}

func NewStore() *Store {
	return &Store{quotes: map[string]storedQuote{}, preparations: map[string]preparation{}}
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
	p.checks = p.checks.clone()
	s.preparations[p.response.PreparationId] = p
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
