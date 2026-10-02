package app;

/** An interface, so a call on a `Greeter`-typed receiver dispatches openly. */
public interface Greeter {
  String greet(String who);
}
