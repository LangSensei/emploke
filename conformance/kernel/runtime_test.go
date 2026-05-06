package kerneltest_test

import (
	"testing"

	kerneltest "github.com/LangSensei/emploke/conformance/kernel"
	"github.com/LangSensei/emploke/kernel"
)

func TestConformance(t *testing.T) {
	kerneltest.RunSuite(t, func() (kernel.Runtime, kernel.Query) {
		rt, q := kerneltest.New()
		return rt, q
	})
}
