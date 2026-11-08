/**
 * Python's `str(float(x))`, which Tinybird uses to render a float param
 * (`{{ Float64(x, 1) }}` → `toFloat64('1.0')`). JavaScript's shortest
 * round-trip digits are the same as Python's; only the layout differs:
 * Python keeps `.0` on whole numbers and switches to exponent notation below
 * 1e-4 and from 1e16, with a signed two-digit exponent.
 */
export function pythonFloat(value: number): string {
  if (Number.isNaN(value)) return 'nan'
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf'
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0'
  const [mantissa = '', exponentText = '0'] = value.toExponential().split('e')
  const exponent = Number(exponentText)
  if (exponent < -4 || exponent >= 16) return `${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`
  const sign = value < 0 ? '-' : ''
  const digits = mantissa.replace('-', '').replace('.', '')
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`
  return `${sign}${digits.slice(0, exponent + 1).padEnd(exponent + 1, '0')}.${digits.slice(exponent + 1) || '0'}`
}

/** The same function as source for the generated queries module, which must not import the plugin. */
export const PYTHON_FLOAT_SOURCE = `/** Python's str(float(x)): how Tinybird renders a float param. */
const pythonFloat = (value: number): string => {
  if (Number.isNaN(value)) return 'nan'
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf'
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0'
  const [mantissa = '', exponentText = '0'] = value.toExponential().split('e')
  const exponent = Number(exponentText)
  if (exponent < -4 || exponent >= 16) return \`\${mantissa}e\${exponent < 0 ? '-' : '+'}\${String(Math.abs(exponent)).padStart(2, '0')}\`
  const sign = value < 0 ? '-' : ''
  const digits = mantissa.replace('-', '').replace('.', '')
  if (exponent < 0) return \`\${sign}0.\${'0'.repeat(-exponent - 1)}\${digits}\`
  return \`\${sign}\${digits.slice(0, exponent + 1).padEnd(exponent + 1, '0')}.\${digits.slice(exponent + 1) || '0'}\`
}`
