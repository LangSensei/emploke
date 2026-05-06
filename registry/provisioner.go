package registry

import (
	"context"

	"github.com/LangSensei/emploke/kernel"
)

// Provisioner materializes resolved capabilities for an agent into a target
// directory. Skills are copied as directories, MCPs are written as a merged
// configuration file.
//
// This interface is intentionally separate from Registry — not all registry
// implementations need provisioning capability.
type Provisioner interface {
	Provision(ctx context.Context, agent kernel.Agent, targetDir string) error
}
