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

export function SkillsIcon({ size = 12, ...props }: ChromeIconProps) {
  return (
    <svg {...sharedProps(size)} {...props}>
      <g transform="translate(0.6 0)">
        <path d="M3 7H13.5V11.8C13.5 15.9 11.4 19.2 8.25 21.2C5.1 19.2 3 15.9 3 11.8Z" />
        <path d="M16.1 16.4V4.6L17.4 2.4L18.7 4.6V16.4" />
        <path d="M14.9 16.4H19.9" />
        <path d="M17.4 16.4V20.2" />
        <circle cx="17.4" cy="21.3" r="0.6" />
      </g>
    </svg>
  );
}
