package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestOutputCannotEscapeDestination(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"../escape", "/../escape"} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("accepted %q", name)
				}
			}()
			outputPath(root, name)
		}()
	}
	if got := outputPath(root, "/nested/index.func"); got != filepath.Join(root, "nested/index.func") {
		t.Fatal(got)
	}
}

func TestJSONPreservesLiteralUnicodeEscapes(t *testing.T) {
	for _, value := range []string{`\u2028`, `\u2029`, "\u2028", "\u2029", `\\u2028`, "<script>&"} {
		encoded := jsonText(value)
		var decoded string
		if err := json.Unmarshal([]byte(encoded), &decoded); err != nil || decoded != value {
			t.Fatalf("%q became %q: %v", value, encoded, err)
		}
	}
}
func TestDeterministicManifestPreservesOrderAndNestedContent(t *testing.T) {
	input := []byte(`{"version":3,"headers":[{"x":1}],"deploymentId":"random","nested":{"z":1,"a":2}}`)
	got := string(deterministicManifest(input))
	want := `{"version":3,"headers":[],"nested":{"z":1,"a":2},"onMatchHeaders":[]}`
	if got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}
func TestParallelPropagatesFailure(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("worker error was discarded")
		}
	}()
	parallel([]any{object{}, object{}}, func(object) { panic("copy failed") })
}
func TestStaticCopyPreservesSymlinkAndExecutableMode(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	mkdir(source)
	check(os.WriteFile(filepath.Join(source, "run"), []byte("executable"), 0755))
	check(os.Symlink("run", filepath.Join(source, "link")))
	dest := filepath.Join(root, "destination")
	copyFile(source, dest)
	target, err := os.Readlink(filepath.Join(dest, "link"))
	if err != nil || target != "run" {
		t.Fatalf("%s: %v", target, err)
	}
	info, err := os.Stat(filepath.Join(dest, "run"))
	if err != nil || info.Mode().Perm() != 0755 {
		t.Fatalf("mode not preserved: %v", err)
	}
}
func TestPrerenderUnicodeOffsetAndAbsentValues(t *testing.T) {
	root := t.TempDir()
	a := &adapter{request: request{Config: object{}, Routing: object{"rsc": object{"contentTypeHeader": "text/x-component"}}, Outputs: object{}}, outputDir: root, parents: map[string]object{"parent": object{"pathname": "/blog"}}}
	state := "Doppelgänger"
	a.prerenders([]any{object{"pathname": "/blog.rsc", "parentOutputId": "parent", "groupId": float64(1), "compute": "static", "htmlSize": float64(0), "config": object{"allowQuery": []any{}}, "fallback": object{"postponedState": state}}})
	config := readJSON(filepath.Join(root, "functions/blog.rsc.prerender-config.json"))
	headers := obj(config["initialHeaders"])
	if headers["content-type"] != `application/x-nextjs-pre-render; state-length=13; origin="text/x-component"` {
		t.Fatal(headers)
	}
	if _, ok := config["initialStatus"]; ok {
		t.Fatal("serialized an absent status")
	}
	data, err := json.Marshal(obj(config["initialMetadata"]))
	if err != nil || string(data) != `{"compute":"static","htmlSize":0}` {
		t.Fatal(string(data), err)
	}
	if string(read(filepath.Join(root, "functions/blog.rsc.prerender-fallback.rsc"))) != state {
		t.Fatal("fallback changed")
	}
}
