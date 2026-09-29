import type { SVGProps } from "react";

type ChromeIconProps = Omit<SVGProps<SVGSVGElement>, "height" | "width"> & {
  size?: number;
};

const sharedProps = (size: number): SVGProps<SVGSVGElement> => ({
  "aria-hidden": true,
  focusable: "false",
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
});

export function PencilIcon({ size = 12, ...props }: ChromeIconProps) {
  return (
    <svg {...sharedProps(size)} {...props}>
      <path d="M4 20l4.2-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z" />
      <path d="m14.7 6.5 3 3" />
    </svg>
  );
}

export function TaskIcon({ size = 12, ...props }: ChromeIconProps) {
  return (
    <svg {...sharedProps(size)} {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

export function DocumentIcon({ size = 12, ...props }: ChromeIconProps) {
  return (
    <svg {...sharedProps(size)} {...props}>
      <path d="M6 3h8l4 4v14H6V3Z" />
      <path d="M14 3v5h4" />
      <path d="M9 12h6M9 16h6" />
    </svg>
  );
}

export function SweepIcon({ size = 12, ...props }: ChromeIconProps) {
  return (
    <svg {...sharedProps(size)} {...props}>
      <path d="m5 4 10 10" />
      <path d="m13 16 4-4 3 3-4 4-7 1 1-7 3 3Z" />
    </svg>
  );
}

export function AiLogIcon({ size = 12, ...props }: ChromeIconProps) {
  return (
    <svg {...sharedProps(size)} {...props}>
      <path d="M4 19V5M4 19h16" />
      <path d="m7 15 4-4 3 2 4-6" />
    </svg>
  );
}
