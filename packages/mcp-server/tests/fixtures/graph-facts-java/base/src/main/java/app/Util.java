package app;

public class Util {
  static String format(String s) {
    return "hello " + s.trim();
  }

  static int neverCalled(int n) {
    return n * 2;
  }
}
