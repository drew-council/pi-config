package output

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

type Field struct {
	Name  string `json:"name"`
	Value any    `json:"value"`
}
type Row []Field

func R(values ...any) Row {
	row := make(Row, 0, len(values)/2)
	for i := 0; i+1 < len(values); i += 2 {
		row = append(row, Field{Name: fmt.Sprint(values[i]), Value: values[i+1]})
	}
	return row
}

func Render(w io.Writer, rows []Row, asJSON bool) error {
	if asJSON {
		objects := make([]map[string]any, len(rows))
		for i, row := range rows {
			objects[i] = map[string]any{}
			for _, f := range row {
				objects[i][f.Name] = f.Value
			}
		}
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		return enc.Encode(objects)
	}
	for _, row := range rows {
		values := make([]string, len(row))
		for i, f := range row {
			values[i] = fmt.Sprint(f.Value)
		}
		if _, err := fmt.Fprintln(w, strings.Join(values, "\t")); err != nil {
			return err
		}
	}
	return nil
}
