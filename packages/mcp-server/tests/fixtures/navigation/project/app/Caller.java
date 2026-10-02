package app;

public class Caller {
  private final Config cfg = new Config("example.test");

  String viaInterface(Greeter g) {
    return g.greet("you");
  }

  String viaClass(Polite p) {
    return p.greet("you");
  }

  String viaRecord() {
    return cfg.url("/health");
  }
}
