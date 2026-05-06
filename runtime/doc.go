// Package runtime defines the Runtime interface for executing Tasks.
//
// The Runtime interface is the command-side contract: how to dispatch, pause,
// resume, kill, complete, and fail tasks. Concrete implementations (e.g.
// runtime/copilot) live in sub-packages.
//
// Import path:
//
//	import "github.com/LangSensei/emploke/runtime"
package runtime // import "github.com/LangSensei/emploke/runtime"
