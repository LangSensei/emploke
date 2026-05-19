import { ChipsInput } from "./ChipsInput";

export interface MetadataFormValues {
  description: string;
  version: string;
  /** undefined = field absent (skill only) */
  prereqs: string;
  /**
   * Catalog v2: dep refs surface to the dashboard as resolved fqns
   * (`{ fqn: string }`). The form holds the fqn strings directly so
   * the chip UI stays simple. Adding new deps still requires switching
   * to source mode (origin URI authoring lives in the markdown
   * frontmatter, not here).
   */
  skills: string[];
  mcps: string[];
}

interface MetadataFormProps {
  kind: "skill" | "agent";
  values: MetadataFormValues;
  onChange: (next: MetadataFormValues) => void;
  availableSkills: string[];
  availableMcps: string[];
  /** Currently-listed deps that aren't in the catalog — shown red. */
  missingSkills?: readonly string[];
  missingMcps?: readonly string[];
  disabled?: boolean;
}

export function MetadataForm({
  kind,
  values,
  onChange,
  availableSkills: _availableSkills,
  availableMcps: _availableMcps,
  missingSkills,
  missingMcps,
  disabled,
}: MetadataFormProps) {
  const update = <K extends keyof MetadataFormValues>(key: K, val: MetadataFormValues[K]) =>
    onChange({ ...values, [key]: val });

  // Catalog v2: form values are fqn strings. We allow remove-only here
  // — adding new deps still requires switching to source mode (the
  // origin-URI authoring path lives in the markdown frontmatter).
  const skillLabels = values.skills;
  const mcpLabels = values.mcps;
  const onSkillsChange = (next: string[]) => {
    const kept = next.filter((label) => values.skills.includes(label));
    update("skills", kept);
  };
  const onMcpsChange = (next: string[]) => {
    const kept = next.filter((label) => values.mcps.includes(label));
    update("mcps", kept);
  };

  return (
    <div className="metadata-form">
      <div className="form-field">
        <label htmlFor="md-description">Description</label>
        <textarea
          id="md-description"
          rows={2}
          value={values.description}
          onChange={(e) => update("description", e.target.value)}
          disabled={disabled}
          placeholder="A short description of what this does."
        />
      </div>

      <div className="form-field">
        <label htmlFor="md-version">Version</label>
        <input
          id="md-version"
          type="text"
          value={values.version}
          onChange={(e) => update("version", e.target.value)}
          disabled={disabled}
          placeholder="0.0.1"
        />
      </div>

      <div className="form-field">
        <label htmlFor="md-skills">Skill dependencies</label>
        <ChipsInput
          inputId="md-skills"
          values={skillLabels}
          onChange={onSkillsChange}
          options={[]}
          placeholder="Edit in source mode to add new dependencies"
          disabled={disabled}
          emptyText="No skill dependencies"
          invalidValues={missingSkills}
        />
        <p className="form-hint">
          Remove with × on each chip. To add new dependencies (which require an origin URI), switch
          to source mode.
        </p>
      </div>

      <div className="form-field">
        <label htmlFor="md-mcps">MCP dependencies</label>
        <ChipsInput
          inputId="md-mcps"
          values={mcpLabels}
          onChange={onMcpsChange}
          options={[]}
          placeholder="Edit in source mode to add new dependencies"
          disabled={disabled}
          emptyText="No MCP dependencies"
          invalidValues={missingMcps}
        />
      </div>

      {kind === "skill" && (
        <div className="form-field">
          <label htmlFor="md-prereqs">Prerequisites</label>
          <textarea
            id="md-prereqs"
            rows={3}
            value={values.prereqs}
            onChange={(e) => update("prereqs", e.target.value)}
            disabled={disabled}
            placeholder="Setup steps the LLM should verify before using this skill."
          />
          <p className="form-hint">
            Free-form text. Leave empty to remove the prereqs field entirely.
          </p>
        </div>
      )}
    </div>
  );
}
