/**
 * Minimal stand-in for @sinclair/typebox.
 *
 * pi resolves the real package through its own loader aliases, which are not
 * available when we bundle the extension standalone for end-to-end tests. Only
 * the schema helpers are stubbed - the tool `execute` functions under test never
 * touch them, so the code paths exercised are the real ones.
 */
const schema = (o?: any) => o ?? {};

export const Type: any = {
  Object: schema,
  String: schema,
  Optional: schema,
  Number: schema,
  Boolean: schema,
  Array: schema,
  Literal: schema,
  Union: schema,
  Record: schema,
};
