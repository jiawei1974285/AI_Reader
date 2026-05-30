type Props = {
  value?: number | null;
  onChange: (value: number | null) => void;
  size?: "sm" | "md";
  label?: string;
};

export function BookRating({
  value,
  onChange,
  size = "md",
  label = "书籍评分",
}: Props) {
  const rating = clampRating(value);
  const starClass = size === "sm" ? "text-sm" : "text-lg";
  const buttonClass =
    size === "sm" ? "w-5 h-5 leading-5" : "w-6 h-6 leading-6";

  return (
    <div className="inline-flex items-center gap-1" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onChange(rating === n ? null : n);
          }}
          className={`${buttonClass} ${starClass} text-center transition hover:scale-110 ${
            rating >= n ? "text-[var(--color-accent)]" : "text-[var(--color-muted)]/45"
          }`}
          title={rating === n ? "取消评分" : `${n} 星`}
          aria-label={rating === n ? "取消评分" : `评为 ${n} 星`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

function clampRating(value?: number | null): number {
  if (!value) return 0;
  if (value < 1) return 0;
  if (value > 5) return 5;
  return Math.round(value);
}
