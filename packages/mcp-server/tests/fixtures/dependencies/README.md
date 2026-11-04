Fixture projects for `analyze_dependencies`.

- `maven-multi/` — a parent POM with two modules, each with the
  `dependency-tree.txt` a build run writes (`mvn dependency:tree
  -DoutputFile=dependency-tree.txt`), and the advisory snapshot where a build
  run's archive carries it (`.cognium/advisory/osv-maven/`). The snapshot is
  hand-written: public advisory ids and range bounds, other fields abridged;
  `TEST-*` ids are fictional. Not a copy of any database.
- `gradle-lock/` — a Gradle project with a `gradle.lockfile`.
- `declared-only/` — a `pom.xml` with no resolved input, beside a
  `package.json` (an ecosystem this tool does not cover).
