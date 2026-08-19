const FIRST_WORDS = [
  'amber', 'apple', 'arbor', 'aspen', 'atlas', 'autumn', 'beacon', 'birch',
  'bloom', 'breeze', 'brook', 'cedar', 'cherry', 'civic', 'clear', 'cloud',
  'coral', 'cove', 'dawn', 'delta', 'ember', 'fern', 'field', 'flint',
  'frost', 'grove', 'harbor', 'hazel', 'ivy', 'jade', 'juniper', 'lake',
  'maple', 'meadow', 'mist', 'moon', 'moss', 'north', 'olive', 'orbit',
  'pebble', 'pine', 'pixel', 'plum', 'pond', 'quartz', 'river', 'robin',
  'silver', 'sky', 'solar', 'sparrow', 'spring', 'stone', 'summer', 'sunny',
  'tide', 'timber', 'valley', 'willow', 'winter',
] as const

const SECOND_WORDS = [
  'anchor', 'apple', 'badge', 'bay', 'beacon', 'berry', 'bird', 'bridge',
  'brook', 'cabin', 'canvas', 'cedar', 'cherry', 'cloud', 'comet', 'coral',
  'cove', 'dawn', 'delta', 'field', 'finch', 'forest', 'garden', 'grove',
  'harbor', 'hill', 'island', 'lantern', 'leaf', 'maple', 'meadow', 'moon',
  'orchard', 'pebble', 'pine', 'pond', 'quartz', 'rain', 'ridge', 'river',
  'robin', 'shore', 'sky', 'sparrow', 'spring', 'stone', 'summit', 'sun',
  'tide', 'trail', 'valley', 'wave', 'willow', 'wind',
] as const

const SEPARATORS = ['.', '_', '-'] as const
const SUFFIX_LETTERS = 'abcdefghjkmnpqrstuvwxyz'

/** 生成与网页端快速创建一致的自然词组邮箱前缀 */
export function randomMailboxLocalPart(prefix = ''): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  const first = FIRST_WORDS[bytes[0] % FIRST_WORDS.length]
  const second = SECOND_WORDS[bytes[1] % SECOND_WORDS.length]
  const separator = SEPARATORS[bytes[2] % SEPARATORS.length]
  const digit = String(bytes[4] % 10)
  const nextDigit = String(bytes[5] % 10)
  const letter = SUFFIX_LETTERS[bytes[6] % SUFFIX_LETTERS.length]
  const variants = [
    `${first}${separator}${second}${digit}${letter}`,
    `${first}${digit}${letter}${separator}${second}`,
    `${first}${separator}${digit}${nextDigit}${second}`,
    `${first}${separator}${second}${separator}${digit}${letter}`,
  ]
  return `${prefix}${variants[bytes[3] % variants.length]}`
}
