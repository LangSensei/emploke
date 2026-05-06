package registry

import "errors"

// ErrNotFound is returned when a requested Agent or Capability does not exist.
var ErrNotFound = errors.New("not found")
