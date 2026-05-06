package copilot

import "github.com/LangSensei/emploke/substrate"

// Compile-time interface compliance check.
var _ substrate.Runtime = (*Runtime)(nil)
