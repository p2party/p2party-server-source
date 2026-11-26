/** A `.sql` file imported `with { type: "text" }`; bun build embeds its text. */
declare module "*.sql" {
  const text: string;
  export default text;
}
