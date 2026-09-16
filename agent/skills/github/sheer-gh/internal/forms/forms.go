package forms

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

type Form struct {
	Name, Description, Type string
	Labels, Assignees       []string
	Body                    []Item
}
type Item struct {
	Type       string `yaml:"type"`
	Attributes struct {
		Label   string   `yaml:"label"`
		Options []string `yaml:"options"`
	} `yaml:"attributes"`
}
type raw struct {
	Name        string    `yaml:"name"`
	Description string    `yaml:"description"`
	Type        string    `yaml:"type"`
	Labels      yaml.Node `yaml:"labels"`
	Assignees   []string  `yaml:"assignees"`
	Body        []Item    `yaml:"body"`
}

func Parse(data []byte) (Form, error) {
	var r raw
	if err := yaml.Unmarshal(data, &r); err != nil {
		return Form{}, err
	}
	f := Form{
		Name:        r.Name,
		Description: r.Description,
		Type:        r.Type,
		Assignees:   r.Assignees,
		Body:        r.Body,
	}
	switch r.Labels.Kind {
	case yaml.SequenceNode:
		for _, n := range r.Labels.Content {
			f.Labels = append(f.Labels, n.Value)
		}
	case yaml.ScalarNode:
		for _, s := range strings.Split(r.Labels.Value, ",") {
			if s = strings.TrimSpace(s); s != "" {
				f.Labels = append(f.Labels, s)
			}
		}
	}
	return f, nil
}

func (f Form) Template() string {
	var b strings.Builder
	for _, i := range f.Body {
		if i.Type == "markdown" || i.Attributes.Label == "" {
			continue
		}
		fmt.Fprintf(&b, "### %s\n\n", i.Attributes.Label)
		if i.Type == "dropdown" {
			b.WriteString("<one of the options below>\n")
			for _, o := range i.Attributes.Options {
				fmt.Fprintf(&b, "  - %s\n", o)
			}
		} else {
			b.WriteString("<...>\n")
		}
		b.WriteString("\n")
	}
	return b.String()
}
