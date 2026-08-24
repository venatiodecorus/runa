/**
 * React wrapper around identiconSpec: builds a real <svg>/<rect> element
 * tree (not dangerouslySetInnerHTML) so it composes normally in React's tree.
 */
import { identiconColors, identiconSpec } from "./identicon-core.js";

export function Identicon({
  id,
  size = 32,
  title,
}: {
  id: string;
  size?: number;
  title?: string;
}) {
  const { hue, cells } = identiconSpec(id);
  const { bg, fg } = identiconColors(hue);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 5 5"
      role="img"
      aria-label={title ?? id}
      style={{ flexShrink: 0, verticalAlign: "middle", borderRadius: 6 }}
    >
      <rect x={0} y={0} width={5} height={5} rx={0.8} fill={bg} />
      {cells.map((filled, i) =>
        filled ? <rect key={i} x={i % 5} y={Math.floor(i / 5)} width={1} height={1} fill={fg} /> : null,
      )}
    </svg>
  );
}
