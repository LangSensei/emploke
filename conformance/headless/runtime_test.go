package headlesstest_test

import (
	"testing"

	headlesstest "github.com/LangSensei/emploke/conformance/headless"
	"github.com/LangSensei/emploke/session/headless"
	"github.com/LangSensei/emploke/substrate"
)

func TestConformance(t *testing.T) {
	headlesstest.RunSuite(t, func() (substrate.Runtime, headless.Repository) {
		rt, repo := headlesstest.New()
		return rt, repo
	})
}
