// Separate entry point: keeps zod out of the root import graph (zod is an optional peer).
export * from './src/actionRuleSchema';
