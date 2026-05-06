package copilot

import "github.com/LangSensei/emploke/kernel"

// Compile-time interface compliance check.
var _ kernel.Runtime = (*Runtime)(nil)
