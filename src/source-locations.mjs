/**
 * Line/column lookup for one source text. Every node the adapter builds carries
 * `range` (offsets) and `loc` (1-based line, 0-based column), the shape ESLint
 * reads for diagnostics, `sourceCode.getText()` and fixes.
 */
export function createLocator(source) {
    const lineStarts = [0];

    for (let i = 0; i < source.length; i++) {
        if (source[i] === '\n') {
            lineStarts.push(i + 1);
        }
    }

    function position(offset) {
        let low = 0;
        let high = lineStarts.length - 1;

        while (low < high) {
            const mid = (low + high + 1) >> 1;

            if (lineStarts[mid] <= offset) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }

        return { line: low + 1, column: offset - lineStarts[low] };
    }

    return {
        position,
        loc: (start, end) => ({ start: position(start), end: position(end) }),
    };
}
