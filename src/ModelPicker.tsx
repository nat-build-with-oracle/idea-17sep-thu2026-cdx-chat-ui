import { Icon } from './Icon'

export default function ModelPicker({ model, models, disabled, onChange }: {
  model: string; models: readonly string[]; disabled: boolean
  onChange: (model: string) => void
}) {
  // The stored model of an older chat may no longer be offered; keep it selectable so
  // the picker never silently reports a model the conversation is not using.
  const options = model && !models.includes(model) ? [model, ...models] : models
  return <label className="model-picker" title="Choose a Codex model">
    <select aria-label="Codex model" value={model} disabled={disabled} onChange={event => onChange(event.target.value)}>
      {options.map(name => <option key={name} value={name}>{name}</option>)}
    </select><Icon name="chevron" size={12} className="turn-down" />
  </label>
}
