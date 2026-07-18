let tail = Promise.resolve()

export function enqueueSpeech<T>(job: () => Promise<T>) {
  const result = tail.then(job, job)
  tail = result.then(
    () => undefined,
    () => undefined
  )
  return result
}
