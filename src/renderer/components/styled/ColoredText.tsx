type Run = { text: string; color?: string };

// Keep the WoW "|c" color runs, strip every other "|" escape (textures, links, pipes).
const ESCAPE_RE =
	/\|\||\|c([0-9a-f]{8})|\|r|\|T[^|]*\|t|\|H[^|]*\|h|\|h|\|./gi;

const tokenize = (s: string): Run[] => {
	const runs: Run[] = [];
	let color: string | undefined;
	let buf = '';
	let i = 0;

	const flush = () => {
		if (buf) runs.push({ text: buf, color });
		buf = '';
	};

	let m: RegExpExecArray | null;
	while ((m = ESCAPE_RE.exec(s)) !== null) {
		buf += s.slice(i, m.index);
		i = ESCAPE_RE.lastIndex;

		const tok = m[0];
		if (tok === '||') {
			buf += '|';
		} else if (m[1]) {
			// drop the leading alpha byte, keep RGB
			flush();
			color = `#${m[1].slice(2).toLowerCase()}`;
		} else if (tok.toLowerCase() === '|r') {
			flush();
			color = undefined;
		}
	}
	buf += s.slice(i);
	flush();
	return runs.filter(r => r.text.length > 0);
};

export const stripColorCodes = (s: string) =>
	tokenize(s)
		.map(r => r.text)
		.join('');

export const ColoredText = ({
	children,
	className,
	style
}: {
	children: string;
	className?: string;
	style?: React.CSSProperties;
}) => {
	const runs = tokenize(children);
	return (
		<p className={className} style={style}>
			{runs.map((r, i) =>
				r.color ? (
					<span
						key={i}
						className="text-size-inherit text-inherit"
						style={{ color: r.color }}
					>
						{r.text}
					</span>
				) : (
					<span key={i}>{r.text}</span>
				)
			)}
		</p>
	);
};
