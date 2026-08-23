import React from "react";

interface IconProps {
    size?: number;
}

function base(size: number): React.SVGProps<SVGSVGElement> {
    return {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.5,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
    };
}

export function PlusIcon({ size = 14 }: IconProps): React.JSX.Element {
    return (
        <svg {...base(size)}>
            <path d="M8 3v10M3 8h10" />
        </svg>
    );
}

export function ImageIcon({ size = 14 }: IconProps): React.JSX.Element {
    return (
        <svg {...base(size)}>
            <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
            <circle cx="5.5" cy="6" r="1.2" />
            <path d="m3.5 12 3.2-3.2 2.1 2 1.5-1.5L13 12" />
        </svg>
    );
}

export function AppShotIcon({ size = 14 }: IconProps): React.JSX.Element {
    return (
        <svg {...base(size)}>
            <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
            <path d="M1.5 6h13M4 4.5h.01M6 4.5h.01" />
            <circle cx="8" cy="9.5" r="2" />
        </svg>
    );
}

export function SearchIcon({ size = 14 }: IconProps): React.JSX.Element {
    return (
        <svg {...base(size)}>
            <circle cx="7" cy="7" r="4" />
            <path d="M10.2 10.2 14 14" />
        </svg>
    );
}

export function MoreIcon({ size = 14 }: IconProps): React.JSX.Element {
    return (
        <svg {...base(size)} fill="currentColor" stroke="none">
            <circle cx="3.5" cy="8" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="12.5" cy="8" r="1.4" />
        </svg>
    );
}

export function SendIcon({ size = 14 }: IconProps): React.JSX.Element {
    return (
        <svg {...base(size)}>
            <path d="M2.5 8 13.5 2.5 10 13.5 7.2 9.2 2.5 8Z" />
            <path d="M13.5 2.5 7.2 9.2" />
        </svg>
    );
}

export function StopIcon({ size = 14 }: IconProps): React.JSX.Element {
    return (
        <svg {...base(size)} fill="currentColor" stroke="none">
            <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
        </svg>
    );
}

export function CloseIcon({ size = 12 }: IconProps): React.JSX.Element {
    return (
        <svg {...base(size)}>
            <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
    );
}

export function EyeIcon({ size = 12 }: IconProps): React.JSX.Element {
    return (
        <svg {...base(size)}>
            <path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8Z" />
            <circle cx="8" cy="8" r="2" />
        </svg>
    );
}

export function EyeOffIcon({ size = 12 }: IconProps): React.JSX.Element {
    return (
        <svg {...base(size)}>
            <path d="M3 3l10 10" />
            <path d="M6.2 4.2A6.6 6.6 0 0 1 8 3.8c4 0 6.5 4.2 6.5 4.2a12.4 12.4 0 0 1-2 2.4M4 5.6A11.9 11.9 0 0 0 1.5 8S4 12.2 8 12.2c.8 0 1.6-.2 2.3-.5" />
        </svg>
    );
}

export function CheckIcon({ size = 12 }: IconProps): React.JSX.Element {
    return (
        <svg {...base(size)}>
            <path d="M3 8.5 6.5 12 13 4" />
        </svg>
    );
}
