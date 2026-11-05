package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"reflect"
	"testing"
)

func requestFrame(req request, maps [][]uint32) []byte {
	data, err := json.Marshal(req)
	check(err)
	frame := append([]byte(requestMagic), make([]byte, 4)...)
	binary.LittleEndian.PutUint32(frame[8:12], uint32(len(data)))
	frame = append(frame, data...)
	frame = binary.LittleEndian.AppendUint32(frame, uint32(len(maps)))
	for _, refs := range maps {
		frame = binary.LittleEndian.AppendUint32(frame, uint32(len(refs)))
		for _, id := range refs {
			frame = binary.LittleEndian.AppendUint32(frame, id)
		}
	}
	return frame
}

func TestDecodeFramedRequest(t *testing.T) {
	req := request{Version: 3, ProjectDir: "/repo/Doppelgänger\u2028", AssetBindings: [][2]string{{"a", "/repo/a"}, {"b", "hash"}}}
	maps := [][]uint32{{1, 0}, {}, {0, 1}}
	frame := requestFrame(req, maps)
	got, err := decodeRequest(bytes.NewReader(frame))
	if err != nil {
		t.Fatal(err)
	}
	req.AssetMaps = maps
	if !reflect.DeepEqual(got, req) {
		t.Fatalf("decoded request differs: %#v", got)
	}
	// Internal JSON snapshots remain readable for existing diagnostic tools.
	req.Version = 2
	data, err := json.Marshal(req)
	check(err)
	got, err = decodeRequest(bytes.NewReader(data))
	if err != nil || !reflect.DeepEqual(got, req) {
		t.Fatalf("JSON request differs: %v, %#v", err, got)
	}
}

func TestDecodeFramedRequestRejectsInvalidLengthsAndReferences(t *testing.T) {
	req := request{Version: 3, AssetBindings: [][2]string{{"a", "/repo/a"}}}
	frame := requestFrame(req, [][]uint32{{0}, {}})
	for end := 0; end < len(frame); end++ {
		if _, err := decodeRequest(bytes.NewReader(frame[:end])); err == nil {
			t.Fatalf("accepted frame truncated at %d", end)
		}
	}
	badLength := bytes.Clone(frame)
	binary.LittleEndian.PutUint32(badLength[8:12], ^uint32(0))
	badCount := bytes.Clone(frame)
	offset := 12 + int(binary.LittleEndian.Uint32(frame[8:12]))
	binary.LittleEndian.PutUint32(badCount[offset:], ^uint32(0))
	badMap := bytes.Clone(frame)
	binary.LittleEndian.PutUint32(badMap[offset+4:], ^uint32(0))
	wrongVersion := req
	wrongVersion.Version = 2
	for _, invalid := range [][]byte{
		badLength, badCount, badMap,
		append(bytes.Clone(frame), 0),
		requestFrame(req, [][]uint32{{1}}),
		requestFrame(wrongVersion, nil),
	} {
		if _, err := decodeRequest(bytes.NewReader(invalid)); err == nil {
			t.Fatal("accepted invalid frame")
		}
	}
}
