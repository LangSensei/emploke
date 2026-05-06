package kernel

import "time"

// Supplement is an entry appended to Task.Supplements as an atomic
// side-effect of Resume(extra).
//
// The kernel records supplements for audit only at this level; cross-impl
// semantic interpretation of historical entries is explicitly not a kernel
// goal. Layer 2 may impose its own semantics on top.
type Supplement struct {
	At      time.Time
	Payload any
}
