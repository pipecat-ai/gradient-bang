import runpy

def main():
    runpy.run_module("gradientbang.pipecat_server.bot", run_name="__main__", alter_sys=True)

if __name__ == "__main__":
    main()