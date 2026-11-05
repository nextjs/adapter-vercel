package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestNodePrefixPreservesOptionsAndReservedFieldPrecedence(t *testing.T) {
	for _, middleware := range []bool{false, true} {
		for _, hasHashes := range []bool{false, true} {
			base := nodeFunctionConfig{OperationType: "PAGE", Handler: "launcher.cjs", Runtime: "nodejs22.x", SupportsMultiPayloads: true, SupportsResponseStreaming: true, ExperimentalAllowBundling: true, LauncherType: "Nodejs", UseWebAPI: middleware}
			base.Framework.Slug, base.Framework.Version = "nextjs", "16.4.0"
			options := object{"runtime": "wrong", "operationType": "wrong", "framework": nil, "filePathMap": "wrong", "fileHashes": object{"preserved": "hash"}, "useWebApi": false, "memory": float64(1024), "maxDuration": float64(0), "description": "Doppelgänger\u2028", "custom": object{"nested": true}}
			var defaults object
			check(json.Unmarshal([]byte(jsonText(base)), &defaults))
			want := merge(options, defaults)
			delete(want, "filePathMap")
			if hasHashes {
				delete(want, "fileHashes")
			}
			var got object
			check(json.Unmarshal([]byte(nodeConfigPrefix(jsonText(base), clone(options), middleware, hasHashes)), &got))
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got=%#v want=%#v", got, want)
			}
		}
	}
}
