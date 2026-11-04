package main

import "testing"

func TestWireRejectsInvalidReferences(t *testing.T) {
	a := &adapter{request: request{AssetBindings: [][2]string{{"a", "/repo/a"}}, AssetMaps: [][]uint32{{0}, {1}}}}
	for _, id := range []any{float64(-1), float64(2), float64(0.5), "0", float64(1)} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("accepted invalid map or binding reference %v", id)
				}
			}()
			a.assets(object{"assetMapId": id})
		}()
	}
	if got := a.assets(object{"assetMapId": float64(0)}); got["a"] != "/repo/a" {
		t.Fatal(got)
	}
}
