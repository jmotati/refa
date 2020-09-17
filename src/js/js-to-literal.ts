import { Simple, Node, Expression, Concatenation, visitAst } from "../ast";
import { assertNever } from "../util";
import { CharSet, CharRange } from "../char-set";
import { DIGIT, WORD, SPACE, LINE_TERMINATOR, withCaseVaryingCharacters, WORD_IU } from "./js-util";
import { Flags } from "./js-flags";
import { UnicodeCaseVarying, UnicodeCaseFolding } from "./unicode";
import { UTF16CaseVarying, UTF16CaseFolding } from "./utf16-case-folding";
import { Literal } from "./parser";

export function toLiteral(concat: Simple<Concatenation>): Literal;
export function toLiteral(expression: Simple<Expression>): Literal;
export function toLiteral(alternatives: readonly Simple<Concatenation>[]): Literal;
export function toLiteral(
	value: Simple<Concatenation> | Simple<Expression> | readonly Simple<Concatenation>[]
): Literal {
	let flags;
	if (Array.isArray(value)) {
		const alternatives: readonly Simple<Concatenation>[] = value;
		flags = getFlags(alternatives);
	} else {
		const node = value as Simple<Expression> | Simple<Concatenation>;
		flags = getFlags([node]);
	}

	let flagsString = "";
	if (flags.ignoreCase) {
		flagsString += "i";
	}
	if (flags.unicode) {
		flagsString += "u";
	}

	return {
		source: toSource(value, flags),
		flags: flagsString,
	};
}

function toSource(
	value: Simple<Concatenation> | Simple<Expression> | readonly Simple<Concatenation>[],
	flags: Flags
): string {
	if (Array.isArray(value)) {
		const alternatives: readonly Simple<Concatenation>[] = value;

		if (alternatives.length === 0) {
			return "[^\\s\\S]";
		} else {
			return alternatives.map(c => toSource(c, flags)).join("|");
		}
	} else {
		const node = value as Simple<Expression> | Simple<Concatenation>;
		if (node.type === "Concatenation") {
			let s = "";
			for (const element of node.elements) {
				switch (element.type) {
					case "Alternation":
						s += "(?:" + toSource(element.alternatives, flags) + ")";
						break;

					case "Assertion":
						s += "(?";
						if (element.kind === "behind") s += "<";
						s += element.negate ? "!" : "=";
						s += toSource(element.alternatives, flags);
						s += ")";
						break;

					case "CharacterClass":
						s += printCharacters(element.characters, flags);
						break;

					case "Quantifier":
						if (element.alternatives.length === 1 && element.alternatives[0].elements.length === 1) {
							const e = element.alternatives[0].elements[0];
							if (e.type === "Alternation" || e.type === "CharacterClass") {
								s += toSource(element.alternatives[0], flags);
							} else {
								s += "(?:" + toSource(element.alternatives, flags) + ")";
							}
						} else {
							s += "(?:" + toSource(element.alternatives, flags) + ")";
						}

						if (element.min === 0 && element.max === Infinity) {
							s += "*";
						} else if (element.min === 1 && element.max === Infinity) {
							s += "+";
						} else if (element.min === 0 && element.max === 1) {
							s += "?";
						} else if (element.max === Infinity) {
							s += `{${element.min},}`;
						} else if (element.min === element.max) {
							s += `{${element.min}}`;
						} else {
							s += `{${element.min},${element.max}}`;
						}
						break;

					default:
						throw assertNever(element);
				}
			}
			return s;
		} else {
			return toSource(node.alternatives, flags);
		}
	}
}


function makeIgnoreCase(cs: CharSet, unicode: boolean): CharSet {
	if (unicode) {
		return withCaseVaryingCharacters(cs, UnicodeCaseFolding, UnicodeCaseVarying);
	} else {
		return withCaseVaryingCharacters(cs, UTF16CaseFolding, UTF16CaseVarying);
	}
}

function isUnicode(value: readonly Simple<Node>[]): boolean | undefined {
	let unicode: boolean | undefined = undefined;

	for (const node of value) {
		visitAst(node, {
			onCharacterClassEnter(node) {
				if (node.characters.maximum === 0x10FFFF) {
					if (unicode === undefined) {
						unicode = true;
					} else if (!unicode) {
						throw new Error("All character sets have to have the same maximum.");
					}
				} else if (node.characters.maximum === 0xFFFF) {
					if (unicode === undefined) {
						unicode = false;
					} else if (unicode) {
						throw new Error("All character sets have to have the same maximum.");
					}
				} else {
					throw new Error("All character sets have to have a maximum of either 0xFFFF or 0x10FFFF.");
				}
			}
		});
	}

	return unicode;
}
function isIgnoreCase(value: Simple<Node>, unicode: boolean): boolean {
	let ignoreCase = true;

	try {
		visitAst(value, {
			onCharacterClassEnter(node) {
				const cs = node.characters;
				if (!cs.equals(makeIgnoreCase(cs, unicode))) {
					ignoreCase = false;
					throw new Error();
				}
			}
		});
	} catch (e) { /* swallow error */ }

	return ignoreCase;
}
function getFlags(value: readonly Simple<Node>[]): Flags {
	const unicode = isUnicode(value);

	if (unicode === undefined) {
		// for some reason, the array of nodes doesn't contain any characters
		return {};
	} else {
		return {
			unicode,
			ignoreCase: value.every(node => isIgnoreCase(node, !!unicode))
		};
	}
}


const printableCharacters = new Map<number, string>();
function addPrintableCharacter(char: number | string, print: string): void {
	if (typeof char === "number") {
		printableCharacters.set(char, print);
	} else {
		printableCharacters.set(char.codePointAt(0)!, print);
	}
}
addPrintableCharacter(0, "\\0");
addPrintableCharacter("\n", "\\n");
addPrintableCharacter("\f", "\\f");
addPrintableCharacter("\t", "\\t");
addPrintableCharacter("\r", "\\r");

/**
 * A set of special characters which cannot be used unescaped in RegExp patterns.
 */
const specialJSRegExp = new Set<number>([..."()[]{}*+?|\\.^$/"].map(c => c.charCodeAt(0)));

const specialJSCharset = new Set<number>([..."\\]-^"].map(c => c.charCodeAt(0)));


function printAsHex(char: number): string {
	if (char < 256) {
		return "\\x" + char.toString(16).padStart(2, "0");
	}
	if (char < 65536) {
		return "\\u" + char.toString(16).padStart(4, "0");
	}
	return "\\u{" + char.toString(16) + "}";
}

function printInCharClass(char: number): string {
	// special characters
	const isSpecial = specialJSCharset.has(char);
	if (isSpecial) return "\\" + String.fromCharCode(char);

	const specialPrintable = printableCharacters.get(char);
	if (specialPrintable) return specialPrintable;

	if (char >= 32 && char < 127) {
		// printable ASCII chars
		return String.fromCharCode(char);
	}

	return printAsHex(char);
}

const printableRanges: readonly CharRange[] = [
	{ min: 0x30, max: 0x39 }, // 0-9
	{ min: 0x41, max: 0x5A }, // A-Z
	{ min: 0x61, max: 0x7A }, // a-z
];
function printRangeImpl(range: CharRange): string {
	if (printableRanges.some(({ min, max }) => min <= range.min && range.max <= max)) {
		// printable ASCII char range
		return String.fromCharCode(range.min) + "-" + String.fromCharCode(range.max);
	} else {
		return printAsHex(range.min) + "-" + printAsHex(range.max);
	}
}
function printRange(range: CharRange): string {
	if (range.min === range.max) return printInCharClass(range.min);
	if (range.min === range.max - 1) return printInCharClass(range.min) + printInCharClass(range.max);

	const size = range.max - range.min + 1;
	if (size <= 6) {
		const candidates = [
			Array.from({ length: size }).map((_, i) => i + range.min).map(printInCharClass).join(""),
			printRangeImpl(range),
		];
		return getShortest(candidates);
	} else {
		return printRangeImpl(range);
	}
}

function printOutsideOfCharClass(char: number): string {
	if (specialJSRegExp.has(char)) {
		return "\\" + String.fromCharCode(char);
	}

	const specialPrint = printableCharacters.get(char);
	if (specialPrint) return specialPrint;

	if (char >= 32 && char < 127) {
		// printable ASCII chars
		return String.fromCharCode(char);
	}

	return printAsHex(char);
}

function rangeEqual(a: readonly CharRange[], b: readonly CharRange[]): boolean {
	const l = a.length;
	if (l !== b.length) return false;
	for (let i = 0; i < l; i++) {
		const aR = a[i];
		const bR = b[i];
		if (aR.min !== bR.min || aR.max !== bR.max) return false;
	}
	return true;
}

function isSupersetOf(set: CharSet, ranges: readonly CharRange[]): boolean {
	return ranges.every(r => set.isSupersetOf(r));
}

function printCharSetSimple(set: CharSet): string {
	let s = "";
	for (const range of set.ranges) {
		s += printRange(range);
	}
	return s;
}
function printCharSetSimpleIgnoreCase(set: CharSet): string {
	const unicode = set.maximum === 0x10FFFF;

	let s = "";
	while (set.ranges.length > 0) {
		const range = set.ranges[0];
		s += printRange(range);
		set = set.without(makeIgnoreCase(CharSet.empty(set.maximum).union([range]), unicode));
	}
	return s;
}

function getShortest(values: string[]): string {
	return values.sort((a, b) => a.length - b.length)[0];
}

function printCharSet(set: CharSet, flags: Flags): string {
	/**
	 * The simplest approach would be to print all ranges but the resulting character class might not be minimal or
	 * readable, so we try to subtract common char sets first in an attempt to make it more readable.
	 */

	let reducedSet = set;
	let reducedPrefix = "";
	if (isSupersetOf(reducedSet, SPACE)) {
		reducedPrefix += "\\s";
		reducedSet = reducedSet.without(SPACE);
	}
	if (flags.ignoreCase && flags.unicode) {
		if (isSupersetOf(reducedSet, WORD_IU)) {
			reducedPrefix += "\\w";
			reducedSet = reducedSet.without(WORD_IU);
		}
	} else {
		if (isSupersetOf(reducedSet, WORD)) {
			reducedPrefix += "\\w";
			reducedSet = reducedSet.without(WORD);
		}
	}
	if (isSupersetOf(reducedSet, DIGIT)) {
		reducedPrefix += "\\d";
		reducedSet = reducedSet.without(DIGIT);
	}

	const candidates: string[] = [
		printCharSetSimple(set)
	];
	if (flags.ignoreCase) {
		candidates.push(printCharSetSimpleIgnoreCase(set));
	}

	if (set !== reducedSet) {
		candidates.push(reducedPrefix + printCharSetSimple(reducedSet));
		if (flags.ignoreCase) {
			candidates.push(reducedPrefix + printCharSetSimpleIgnoreCase(reducedSet));
		}
	}

	return getShortest(candidates);
}

function printCharacters(chars: CharSet, flags: Flags): string {
	if (chars.isAll) return "[\\s\\S]";
	if (chars.isEmpty) return "[^\\s\\S]";

	const min = chars.ranges[0].min;
	if (chars.ranges.length === 1 && min === chars.ranges[0].max) {
		// a single character
		return printOutsideOfCharClass(min);
	} else if (flags.ignoreCase) {
		const single = makeIgnoreCase(CharSet.empty(chars.maximum).union([{ min: min, max: min }]), !!flags.unicode);
		if (single.equals(chars)) {
			// a single character because of we ignore case
			return printOutsideOfCharClass(min);
		}
	}


	// if the first min is 0, then it's most likely negated, so don't even bother checking non-negated char sets
	if (chars.ranges[0].min > 0) {
		if (rangeEqual(chars.ranges, DIGIT)) return "\\d";
		if (rangeEqual(chars.ranges, SPACE)) return "\\s";
		if (flags.ignoreCase && flags.unicode) {
			if (rangeEqual(chars.ranges, WORD_IU)) return "\\w";
		} else {
			if (rangeEqual(chars.ranges, WORD)) return "\\w";
		}
	}

	const negated = chars.negate();
	if (rangeEqual(negated.ranges, LINE_TERMINATOR)) return ".";
	if (rangeEqual(negated.ranges, DIGIT)) return "\\D";
	if (rangeEqual(negated.ranges, SPACE)) return "\\S";
	if (flags.ignoreCase && flags.unicode) {
		if (rangeEqual(negated.ranges, WORD_IU)) return "\\W";
	} else {
		if (rangeEqual(negated.ranges, WORD)) return "\\W";
	}

	const source = printCharSet(chars, flags);
	const negatedSource = printCharSet(negated, flags);

	if (source.length <= negatedSource.length) {
		return `[${source}]`;
	} else {
		return `[^${negatedSource}]`;
	}
}
