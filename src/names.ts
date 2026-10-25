/**
 * The atom Erlang uses for a module or registered name written the Elixir
 * way: `MyApp.Users` is `Elixir.MyApp.Users`, as in Elixir itself. Names that
 * start with a lowercase letter (`lists`, `rex`) or already with `Elixir.`
 * are kept as they are.
 */
export function erlangName(name: string): string {
  return /^[A-Z]/.test(name) && !name.startsWith("Elixir.") ? `Elixir.${name}` : name;
}
