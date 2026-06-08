interface FeatureChipsProps {
  readonly features: readonly string[];
}

/** Lista de chips de features de una app. */
export function FeatureChips({ features }: FeatureChipsProps) {
  return (
    <ul className="mt-3.5 flex flex-wrap gap-[7px]">
      {features.map((feature) => (
        <li
          key={feature}
          className="rounded-lg border border-border bg-surface-2 px-2.5 py-[5px] text-[12px] text-ink-muted"
        >
          {feature}
        </li>
      ))}
    </ul>
  );
}
