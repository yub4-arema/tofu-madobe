export function takeCompleteSentences(text: string) {
  const sentences: string[] = []
  let end = 0
  for (const match of text.matchAll(/[^。！？!?]+[。！？!?]+/g)) {
    const sentence = match[0].trim()
    if (sentence) sentences.push(sentence)
    end = (match.index ?? 0) + match[0].length
  }
  return { sentences, rest: text.slice(end) }
}
