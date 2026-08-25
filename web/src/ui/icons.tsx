/**
 * Runa icon set — hand-rolled inline SVG, stroke-based, 24×24 viewBox,
 * currentColor. No icon library dependency; add icons here as needed so
 * the whole app draws from one consistent set.
 */
import type { ReactNode } from "react";

interface IconProps {
  size?: number;
  title?: string;
  className?: string;
  strokeWidth?: number;
}

function makeIcon(children: ReactNode, defaultStroke = 1.8) {
  return function Icon({ size = 16, title, className, strokeWidth = defaultStroke }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden={title === undefined ? true : undefined}
        role={title !== undefined ? "img" : undefined}
      >
        {title !== undefined && <title>{title}</title>}
        {children}
      </svg>
    );
  };
}

/** Brand mark: the Raidō rune (ᚱ — "R", for Runa), drawn as strokes. */
export const RuneMark = makeIcon(
  <>
    <path d="M8.5 3.5v17" />
    <path d="M8.5 3.5l7 4.75-7 4.75" />
    <path d="M10.5 11.7l5.5 8.8" />
  </>,
  2.2,
);

export const IconGlobe = makeIcon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a13.5 13.5 0 0 1 3.5 9A13.5 13.5 0 0 1 12 21a13.5 13.5 0 0 1-3.5-9A13.5 13.5 0 0 1 12 3z" />
  </>,
);

export const IconLock = makeIcon(
  <>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </>,
);

export const IconShieldCheck = makeIcon(
  <>
    <path d="M12 3l7 2.8v5.4c0 4.4-2.9 8.3-7 9.8-4.1-1.5-7-5.4-7-9.8V5.8L12 3z" />
    <path d="M9 12l2.2 2.2L15.5 9.7" />
  </>,
);

export const IconCheck = makeIcon(<path d="M4.5 12.5l5 5 10-10.5" />);

export const IconReply = makeIcon(
  <>
    <path d="M9 16.5L4 11.5 9 6.5" />
    <path d="M20 19v-3.5a4 4 0 0 0-4-4H4" />
  </>,
);

export const IconReplyMarker = makeIcon(
  <>
    <path d="M4.5 4.5V11a4 4 0 0 0 4 4h11" />
    <path d="M15 10.5l4.5 4.5-4.5 4.5" />
  </>,
);

export const IconArrowLeft = makeIcon(
  <>
    <path d="M19 12H5" />
    <path d="M12 19l-7-7 7-7" />
  </>,
);

export const IconSend = makeIcon(
  <>
    <path d="M21.5 2.5L11 13" />
    <path d="M21.5 2.5l-6.8 19-3.2-8.5-8.5-3.2 18.5-7.3z" />
  </>,
);

export const IconMessage = makeIcon(
  <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 12.5 3H13a8.5 8.5 0 0 1 8 8v.5z" />,
);

export const IconFeed = makeIcon(
  <>
    <path d="M4 11a9 9 0 0 1 9 9" />
    <path d="M4 4a16 16 0 0 1 16 16" />
    <circle cx="5.2" cy="18.8" r="1.2" fill="currentColor" stroke="none" />
  </>,
);

export const IconPen = makeIcon(
  <>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
  </>,
);

export const IconDevices = makeIcon(
  <>
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </>,
);

export const IconUser = makeIcon(
  <>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7.5" r="4" />
  </>,
);

export const IconUsers = makeIcon(
  <>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </>,
);

export const IconSearch = makeIcon(
  <>
    <circle cx="11" cy="11" r="7.5" />
    <path d="M16.5 16.5L21 21" />
  </>,
);

export const IconFlag = makeIcon(
  <>
    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
    <path d="M4 22v-7" />
  </>,
);

export const IconSun = makeIcon(
  <>
    <circle cx="12" cy="12" r="4.25" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
  </>,
);

export const IconMoon = makeIcon(
  <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
);

export const IconRefresh = makeIcon(
  <>
    <path d="M23 4v6h-6" />
    <path d="M1 20v-6h6" />
    <path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10" />
    <path d="M1 14l4.6 4.4A9 9 0 0 0 20.5 15" />
  </>,
);

export const IconKey = makeIcon(
  <>
    <circle cx="7.5" cy="15.5" r="4" />
    <path d="M10.3 12.7L21 2" />
    <path d="M15 8l3 3" />
    <path d="M18.5 4.5l2 2" />
  </>,
);

export const IconDownload = makeIcon(
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 3v12" />
  </>,
);

export const IconX = makeIcon(
  <>
    <path d="M18 6L6 18" />
    <path d="M6 6l12 12" />
  </>,
);

export const IconAlert = makeIcon(
  <>
    <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4" />
    <circle cx="12" cy="17" r="0.5" fill="currentColor" stroke="none" />
  </>,
);

export const IconLogOut = makeIcon(
  <>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5" />
    <path d="M21 12H9" />
  </>,
);

export const IconChevronDown = makeIcon(<path d="M6 9l6 6 6-6" />);

export const IconInbox = makeIcon(
  <>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z" />
  </>,
);

/** Loader arc — pair with the `spin` CSS class. */
export const IconLoader = makeIcon(<path d="M21 12a9 9 0 1 1-6.2-8.6" />);

/** Standard loading line: spinner + label. */
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading">
      <IconLoader size={15} className="spin" />
      <span>{label}</span>
    </div>
  );
}
