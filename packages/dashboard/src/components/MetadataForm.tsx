import { ChipsInput } from "./ChipsInput";

export interface MetadataFormValues {
  description: string;
  version: string;
  /** undefined = field absent (skill only) */
  prereqs: string;
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
  availableSkills,
  availableMcps,
  missingSkills,
  missingMcps,
  disabled,
}: MetadataFormProps) {
  const update = <K extends keyof MetadataFormValues>(key: K, val: MetadataFormValues[K]) =>
    onChange({ ...values, [key]: val });

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
          values={values.skills}
          onChange={(v) => update("skills", v)}
          options={availableSkills}
          placeholder="Type to search or add custom..."
          disabled={disabled}
          emptyText="No skill dependencies"
          invalidValues={missingSkills}
        />
      </div>

      <div className="form-field">
        <label htmlFor="md-mcps">MCP dependencies</label>
        <ChipsInput
          inputId="md-mcps"
          values={values.mcps}
          onChange={(v) => update("mcps", v)}
          options={availableMcps}
          placeholder="Type to search or add custom..."
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
