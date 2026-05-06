// Package session is the parent namespace for emploke's session domains.
//
// A "session" is an isolated agent execution. There are two kinds, each
// living in its own subpackage with its own bounded context:
//
//   - session/headless: one-shot, goal-driven Task with a 6-state lifecycle.
//   - session/interactive: long-lived PTY-attached process for chat-style
//     interaction (planned, not yet implemented).
//
// This parent package contains no code. Each subpackage owns its own
// aggregates, repositories, and (where applicable) interfaces. The
// substrate package owns execution contracts (Runtime); catalog owns
// agent and capability descriptions.
//
// The two contexts deliberately do not share types or interfaces; their
// invariants and verb sets differ enough that any shared abstraction would
// be a leak. They only share the higher-level concept "an isolated agent
// execution" which this namespace name reflects.
package session
