package app;

public class Main {
  public static void main(String[] args) {
    System.out.println(Util.format(args.length > 0 ? args[0] : "world"));
  }
}
