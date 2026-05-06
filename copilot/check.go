package copilot

import "github.com/LangSensei/emploke/kernel"

// Compile-time interface compliance checks.
var (
	_ kernel.Runtime = (*Runtime)(nil)
	_ kernel.Query   = (*Query)(nil)
)
