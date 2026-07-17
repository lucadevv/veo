/** Wordmark de VEO: el logotipo display + el punto teal de marca con halo. */
export function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="font-display text-[26px] font-bold leading-none">VEO</span>
      <span
        className="mt-1 h-[9px] w-[9px] rounded-full bg-brand"
        style={{ boxShadow: '0 0 14px rgba(0,117,169,.45)' }}
        aria-hidden="true"
      />
    </div>
  );
}
