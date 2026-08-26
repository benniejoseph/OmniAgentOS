import Image from "next/image";
import { clsx } from "clsx";

export function AsaelMark({
  size = 36,
  className,
  priority = false,
}: {
  size?: number;
  className?: string;
  priority?: boolean;
}) {
  return (
    <span
      className={clsx(
        "relative block shrink-0 overflow-hidden rounded-[28%] bg-[#060a09] shadow-[0_0_0_1px_oklch(0.78_0.08_165/0.18),0_6px_20px_oklch(0.48_0.12_165/0.12)]",
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <Image
        src="/asael-mark-128.webp"
        alt=""
        fill
        priority={priority}
        unoptimized
        sizes={`${size}px`}
        className="object-cover"
      />
    </span>
  );
}
