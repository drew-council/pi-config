package main

import (
	"os"

	"github.com/drew-council/sheer-gh/internal/app"
)

func main() { os.Exit(app.Run(os.Args, os.Stdout, os.Stderr)) }
