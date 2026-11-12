// Strips emails, phone numbers and long digit strings from evidence text before it is sent to a model.
export function redact(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[EMAIL]")
    // international or separated phone numbers: +234 801 234 5678, (555) 123-4567, 0801-234-5678
    .replace(/\+\d[\d\s().-]{6,}\d/g, "[PHONE]")
    .replace(/\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?/g, "[PHONE]")
    // any remaining run of 9 or more digits (account numbers, IDs, unseparated phones)
    .replace(/\d{9,}/g, "[NUMBER]");
}
