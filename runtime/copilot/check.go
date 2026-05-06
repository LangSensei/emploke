package copilot

import "github.com/LangSensei/emploke/runtime"

// Compile-time interface compliance check.
var _ runtime.Runtime = (*Runtime)(nil)
