package app;

/** A record, which the engine sees only when asked for navigation types. */
public record Config(String host) {
  public String url(String path) {
    return host + path;
  }
}
