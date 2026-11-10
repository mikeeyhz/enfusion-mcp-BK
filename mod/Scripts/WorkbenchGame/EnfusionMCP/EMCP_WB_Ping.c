/**
 * EMCP_WB_Ping.c - Health check handler for EnfusionMCP Workbench bridge
 *
 * Returns status and current editor mode (edit vs game).
 * Called via NET API TCP protocol: APIFunc = "EMCP_WB_Ping"
 */

class EMCP_WB_PingRequest : JsonApiStruct
{
	void EMCP_WB_PingRequest()
	{
		// No request parameters needed for ping
	}
}

class EMCP_WB_PingResponse : JsonApiStruct
{
	string status;
	string mode;
	string message;
	string projectFile;

	void EMCP_WB_PingResponse()
	{
		RegV("status");
		RegV("mode");
		RegV("message");
		RegV("projectFile");
	}
}

class EMCP_WB_Ping : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_PingRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_PingResponse resp = new EMCP_WB_PingResponse();
		resp.projectFile = EMCP_WB_ProjectRequest.ActiveProjectFile();

		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		if (!worldEditor)
		{
			resp.status = "ok";
			resp.mode = "no_world_editor";
			resp.message = "EnfusionMCP Workbench bridge active (no WorldEditor module)";
			return resp;
		}

		WorldEditorAPI api = worldEditor.GetApi();
		if (api)
		{
			resp.status = "ok";
			resp.mode = "edit";
			resp.message = "EnfusionMCP Workbench bridge active";
		}
		else
		{
			resp.status = "ok";
			resp.mode = "game";
			resp.message = "EnfusionMCP Workbench bridge active (game mode)";
		}

		return resp;
	}
}

// All live handlers check the active .gproj again at dispatch, so a project
// change after the client's ping cannot send an edit to the wrong project.
class EMCP_WB_ProjectRequest : JsonApiStruct
{
	string expectedProjectFile;

	void EMCP_WB_ProjectRequest()
	{
		RegV("expectedProjectFile");
	}

	// GetCurrentGameProjectFile returns the base game's settings for addon
	// sessions. Identify the selected addon by its -gproj and verify that the
	// same file is present in Workbench's currently loaded addon mounts.
	static string ActiveProjectFile()
	{
		string launchProject;
		if (!System.GetCLIParam("gproj", launchProject) || launchProject.IsEmpty())
			return string.Empty;

		string launchPath = launchProject;
		launchPath.Replace("\\", "/");
		int slash = launchPath.LastIndexOf("/");
		if (slash < 0)
			return string.Empty;

		string fileName = launchPath.Substring(slash + 1, launchPath.Length() - slash - 1);
		array<string> loadedAddons = {};
		GameProject.GetLoadedAddons(loadedAddons);
		foreach (string guid : loadedAddons)
		{
			string mountedPath;
			string addonId = GameProject.GetAddonID(guid);
			if (addonId.IsEmpty() || !Workbench.GetAbsolutePath("$" + addonId + ":" + fileName, mountedPath))
				continue;

			mountedPath.Replace("\\", "/");
			if (mountedPath == launchPath)
				return launchProject;
		}
		return string.Empty;
	}

	static JsonApiStruct Check(JsonApiStruct request)
	{
		EMCP_WB_ProjectRequest projectRequest = EMCP_WB_ProjectRequest.Cast(request);
		string active = EMCP_WB_ProjectRequest.ActiveProjectFile();
		if (projectRequest && !active.IsEmpty() && active == projectRequest.expectedProjectFile)
			return null;

		EMCP_WB_PingResponse error = new EMCP_WB_PingResponse();
		error.status = "project_mismatch";
		error.message = "Workbench rejected the request because its active project does not match the verified .gproj.";
		error.projectFile = active;
		return error;
	}
}
