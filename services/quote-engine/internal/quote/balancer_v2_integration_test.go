package quote

import (
	"context"
	"math/big"
	"os"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/kuchmenko/epeius/services/quote-engine/internal/rpc"
)

func TestBalancerHistoricalArchiveFixtures(t *testing.T) {
	endpoint := os.Getenv("ETHEREUM_ARCHIVE_RPC_URL")
	if endpoint == "" {
		t.Skip("ETHEREUM_ARCHIVE_RPC_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client, _, err := rpc.Open(ctx, "ethereum", 1, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	header, err := client.HeaderByNumber(ctx, big.NewInt(19_000_000))
	if err != nil {
		t.Fatal(err)
	}
	const expectedHash = "0xcf384012b91b081230cdf17a3f7dd370d8e67056058af6b272b3d54aa2714fac"
	if header.Hash() != common.HexToHash(expectedHash) {
		t.Fatalf("block 19000000 hash = %s", header.Hash())
	}

	fixtures := []struct {
		pool, in, out, amount, output string
	}{
		{weightedPool, bal, weth, "1000000000000000000", "1655948921020267"},
		{weightedPool, weth, bal, "1000000000000000000", "591835794858355497336"},
		{stablePool, dai, usdc, "1000000000000000000", "1000023"},
		{stablePool, usdc, dai, "1000000", "999876305476793362"},
		{composablePool, wsteth, weth, "1000000000000000000", "1152933356389882853"},
		{composablePool, weth, wsteth, "1000000000000000000", "867178645851903897"},
	}
	verified := map[string]bool{}
	for _, fixture := range fixtures {
		if !verified[fixture.pool] {
			if err := verifyBalancerPool(ctx, client, common.HexToAddress(balancerVault), common.HexToHash(fixture.pool), header.Hash()); err != nil {
				t.Fatalf("pool %s: %v", fixture.pool, err)
			}
			verified[fixture.pool] = true
		}
		amount, _ := new(big.Int).SetString(fixture.amount, 10)
		want, _ := new(big.Int).SetString(fixture.output, 10)
		got, eligible, err := quoteBalancerPool(ctx, client, common.HexToAddress(balancerVault), common.HexToHash(fixture.pool), common.HexToAddress(fixture.in), common.HexToAddress(fixture.out), amount, header.Hash())
		if err != nil || !eligible || got.Cmp(want) != 0 {
			t.Fatalf("%s %s: output=%v eligible=%v error=%v", fixture.in, fixture.out, got, eligible, err)
		}
	}
}
