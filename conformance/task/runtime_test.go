package tasktest_test

import (
	"testing"

	tasktest "github.com/LangSensei/emploke/conformance/task"
)

func TestConformance(t *testing.T) {
	tasktest.RunSuite(t, func() (*tasktest.Runtime, *tasktest.Repository) {
		return tasktest.New()
	})
}
